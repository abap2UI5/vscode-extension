CLASS zcl_flow DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS render_dialog RETURNING VALUE(result) TYPE string.
    METHODS on_event.
    METHODS render_list RETURNING VALUE(result) TYPE string.
ENDCLASS.

CLASS zcl_flow IMPLEMENTATION.

  METHOD z2ui5_if_app~main.
    me->client = client.
    IF client->check_on_init( ).
      client->view_display( render_list( ) ).
    ENDIF.
    client->popup_display( render_dialog( ) ).
  ENDMETHOD.

  METHOD render_dialog.
    DATA(popup) = z2ui5_cl_ui5_view_builder=>factory( ).
    popup->ele( `Dialog` )->a( n = `title` v = `Hi` )->tag( `Text` )->a( n = `text` v = `hello` ).
    result = popup->stringify( ).
  ENDMETHOD.

  METHOD render_list.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( `Page` )->tag( `Button` )->a( n = `press` v = client->_event( `save` ) ).
    result = view->stringify( ).
  ENDMETHOD.

  METHOD on_event.
    CASE client->get_event( ).
      WHEN `SAVE`.
        client->nav_app_call( NEW zcl_flow( ) ).
        client->view_display( render_list( ) ).
      WHEN `OTHER`.
        client->view_display( render_list( ) ).
        client->view_display( render_dialog( ) ).
    ENDCASE.
  ENDMETHOD.

ENDCLASS.
