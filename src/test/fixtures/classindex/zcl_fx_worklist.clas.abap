* Inherits cs_event from zcl_fx_list_report (the rap-ext worklist shape):
* every _event( ) below raises one of the superclass's BACKEND events.
CLASS zcl_fx_worklist DEFINITION PUBLIC
  INHERITING FROM zcl_fx_list_report
  CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS z2ui5_if_app~main REDEFINITION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_fx_worklist IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    CASE client->get_event( ).
      WHEN cs_event-back.
        client->nav_app_leave( ).
        RETURN.
    ENDCASE.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = `View` ns = `mvc`
        )->a( n = `xmlns` v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->ele( `Page`
            )->a( n = `title` v = `Worklist`
            )->tag( `SearchField`
                )->a( n = `value` v = client->_bind( mv_search )
                )->a( n = `search` v = client->_event( val = cs_event-search )
            )->tag( `Button`
                )->a( n = `text` v = `Back`
                )->a( n = `press` v = client->_event( cs_event-back )
            )->tag( `Button`
                )->a( n = `text` v = `Back again`
                )->a( n = `press` v = client->_event( zcl_fx_list_report=>cs_event-back )
        )->end( ).
    client->view_display( view->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
