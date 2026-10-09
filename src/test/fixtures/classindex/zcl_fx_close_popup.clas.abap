* Declares no cs_event and inherits none: the bare cs_event-popup_close is the
* client's frontend action, raised here as a backend event - the true positive.
CLASS zcl_fx_close_popup DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_fx_close_popup IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = `View` ns = `mvc`
        )->a( n = `xmlns` v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->ele( `Page`
            )->a( n = `title` v = `Popup`
            )->tag( `Button`
                )->a( n = `text` v = `Close`
                )->a( n = `press` v = client->_event( cs_event-popup_close )
        )->end( ).
    client->view_display( view->stringify( ) ).

  ENDMETHOD.

ENDCLASS.
